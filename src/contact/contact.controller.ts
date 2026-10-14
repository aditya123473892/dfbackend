import { Controller, Get, Post, Body, Param, HttpStatus, UseGuards } from '@nestjs/common';
import { ApiTags, ApiOperation, ApiResponse, ApiBody, ApiParam, ApiBearerAuth } from '@nestjs/swagger';
import { ContactService } from './contact.service';
import { CreateContactDto } from './dto/create-contact.dto';
import { Contact } from '../common/schemas/contact.schema';
import { ERole } from 'src/common/enums';
import { JwtAuthGuard, RolesGuard } from 'src/common/guards';
import { Roles } from 'src/common/decorators';
import { MailService } from 'src/mail/mail.service';
import { UsersService } from 'src/users/users.service';

@ApiTags('contact')
@Controller('contact')
export class ContactController {
    constructor(
        private readonly contactService: ContactService,
        private readonly mailService: MailService,
        private readonly usersService: UsersService,
    ) { }


    @Post()
    @ApiOperation({ summary: 'Create contact', description: 'Creates a contact us' })
    @ApiResponse({ status: HttpStatus.CREATED, description: 'Contact created successfully', type: Contact })
    @ApiResponse({ status: HttpStatus.BAD_REQUEST, description: 'Invalid request data' })
    @ApiBody({
        schema: {
            type: 'object',
            properties: {
                name: { type: 'string', description: 'Your Name' },
                email: { type: 'string', description: 'Your Email' },
                // phone: { type: 'string', description: 'Your Phone Number' },
                message: { type: 'string', description: 'Write a Message' },
            },
        },
    })
    async create(@Body() contactData: CreateContactDto) {
        const contact = await this.contactService.create(contactData);

        if (contact) {
            const admins = await this.usersService.findAdmin()

            if (admins.length > 0) {
                const adminEmails = admins.map(admin => admin.username); // Extract admin emails
                await this.mailService.sendContactMessage(adminEmails, contact);
            }
        }

        return {
            _doc: contact,
            statusCode: 201,
        };
    }


    @Roles(ERole.ADMIN)
    @ApiBearerAuth()
    @UseGuards(JwtAuthGuard, RolesGuard)
    @Get()
    @ApiOperation({ summary: 'Get all contacts', description: 'Get all contacts' })
    async findAll() {
        try {
            return this.contactService.findAll();
        } catch (err) {
            console.error(err);
            throw new Error('An error occurred while fetching contact');
        }
    }

}
